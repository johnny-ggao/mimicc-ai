import {
  RemoveMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
} from "@langchain/core/messages";

/**
 * Turning messages into bytes and back, without a general object deserialiser.
 *
 * LangChain ships one — `load()` from `@langchain/core/load` — and the docs point
 * at it. We do not use it, deliberately, and this is the only place that decision
 * is visible so it is written down here rather than discovered later.
 *
 * `load()` reads a class path out of the line and instantiates that class,
 * calling its constructor with the payload. Its own warning is blunt: *never
 * call `load()` on untrusted or user-supplied input … arbitrary class
 * instantiation, secret exfiltration, and server-side request forgery*. Measured
 * against it: a hand-edited line naming `ChatPromptTemplate` produced a
 * `ChatPromptTemplate`, no complaint. A session file is a file — in development
 * it sits inside the working directory — so it is exactly the "somebody could
 * edit this" case that warning is about.
 *
 * The mapper below reaches six message types through a switch and throws on
 * anything else, which is the whole of what a transcript needs. It also happens
 * to produce `{"type":"ai","data":{…}}` rather than
 * `{"lc":1,"type":"constructor","id":["langchain_core",…]}` — 33% smaller and
 * legible to `jq`, which is the point of choosing JSONL in the first place.
 *
 * Fidelity is measured, not assumed: id, content, tool_calls, tool_call_id, name,
 * response_metadata and usage_metadata all survive a round trip.
 */

/** Marks a message nested inside some other value. See {@link encodeValue}. */
const MESSAGE_TAG = "@m";

interface TaggedMessage {
  [MESSAGE_TAG]: StoredMessage;
}

/**
 * One message, as it appears on a `message` line.
 *
 * `RemoveMessage` is handled here rather than left to LangChain's mapper because
 * the mapper is asymmetric about it: `mapChatMessagesToStoredMessages` encodes it
 * happily as `type: "remove"`, and `mapStoredMessagesToChatMessages` then throws
 * `Got unexpected type: remove` reading it back. A saver that can write a value
 * it cannot read is a saver that corrupts a thread on the next open, so the
 * asymmetry is closed here instead of being inherited.
 */
export function encodeMessage(message: BaseMessage): StoredMessage {
  const [stored] = mapChatMessagesToStoredMessages([message]);
  // One in, one out. The check is for the compiler (noUncheckedIndexedAccess),
  // not for a case that can happen.
  if (stored === undefined) throw new Error("message failed to encode");
  return stored;
}

export function decodeMessage(stored: StoredMessage): BaseMessage {
  if (stored.type === "remove") {
    const id = stored.data.id;
    if (typeof id !== "string") throw new Error("remove message without an id");
    return new RemoveMessage({ id });
  }
  const [message] = mapStoredMessagesToChatMessages([stored]);
  if (message === undefined)
    throw new Error(`message failed to decode: ${stored.type}`);
  return message;
}

/**
 * Encodes a value that may contain messages anywhere inside it.
 *
 * Needed because messages do not only live in the `messages` channel: a pending
 * write carries them as its payload, and middleware state can hold one (the
 * summary message a later ticket will store alongside its cutoff index). Walking
 * the value is the only way to catch both without enumerating every shape.
 *
 * The tag is a one-key object, so a plain object that happens to have exactly
 * that single key would round-trip as a message and fail. Accepted rather than
 * escaped: the alternative is the escaping scheme `load()` needs, and the values
 * reaching here are ours, not tool output.
 */
export function encodeValue(value: unknown): unknown {
  if (isMessage(value)) return { [MESSAGE_TAG]: encodeMessage(value) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        encodeValue(inner),
      ]),
    );
  }
  return value;
}

export function decodeValue(value: unknown): unknown {
  if (isTagged(value)) return decodeMessage(value[MESSAGE_TAG]);
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        decodeValue(inner),
      ]),
    );
  }
  return value;
}

/**
 * Structural, not `instanceof`. Messages cross module boundaries here — the
 * graph builds them, we serialise them — and a duplicated `@langchain/core` in
 * the dependency tree makes `instanceof` quietly false.
 */
function isMessage(value: unknown): value is BaseMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    "getType" in value &&
    typeof (value as BaseMessage).getType === "function" &&
    "content" in value
  );
}

function isTagged(value: unknown): value is TaggedMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === MESSAGE_TAG;
}
