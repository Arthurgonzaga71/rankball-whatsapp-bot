import { proto } from '@whiskeysockets/baileys'

export function serializePollMessage(message) {
  return proto.WebMessageInfo.toObject(proto.WebMessageInfo.fromObject(message), { bytes: String, longs: String, enums: String })
}

export function restorePollMessage(snapshot) {
  return proto.WebMessageInfo.fromObject(snapshot)
}
