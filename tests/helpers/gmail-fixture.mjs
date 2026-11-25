export function gmailPartData(bytes) {
  const buffer = Buffer.from(bytes);
  return { data: buffer.toString("base64url"), size: buffer.length };
}

export function gmailTextPart(text, mimeType = "text/plain") {
  return {
    mimeType,
    headers: [{ name: "Content-Type", value: `${mimeType}; charset=UTF-8` }],
    body: gmailPartData(text),
  };
}

export function gmailMessage(id, { sender, subject, receivedAt, threadId = id, payload }) {
  const headers = [...(payload.headers ?? []), { name: "From", value: sender }, { name: "Subject", value: subject }];
  return { id, threadId, internalDate: String(Date.parse(receivedAt)), payload: { ...payload, headers } };
}

export function stubGmail(context, { list, get, getAttachment }) {
  Object.assign(context.Utilities, {
    base64Decode: data => [...Buffer.from(data, "base64")],
    base64DecodeWebSafe: data => [...Buffer.from(data, "base64url")],
    base64Encode: bytes => Buffer.from(bytes).toString("base64"),
    newBlob: (bytes, mimeType, name) => ({
      bytes, mimeType, name,
      getDataAsString: charset => new TextDecoder(charset).decode(Buffer.from(bytes)),
    }),
  });
  context.Gmail = { Users: { Messages: { list, get, Attachments: { get: getAttachment } } } };
}
