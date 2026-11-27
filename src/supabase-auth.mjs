import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys'

// A single process owns each session. Serializing operations avoids stale writes
// when Baileys updates the same signal key concurrently.
export async function useSupabaseAuthState(client, sessionId = 'rankball') {
  let pending = Promise.resolve()
  const serialize = operation => {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }
  const table = () => client.from('whatsapp_auth_state')
  const decode = value => JSON.parse(JSON.stringify(value), BufferJSON.reviver)
  const encode = value => JSON.parse(JSON.stringify(value, BufferJSON.replacer))
  const read = async key => {
    const { data, error } = await table().select('value').eq('session_id', sessionId).eq('key', key).maybeSingle()
    if (error) throw error
    return data ? decode(data.value) : null
  }
  const creds = await read('creds') || initAuthCreds()
  const write = async (key, value) => {
    const query = value == null
      ? table().delete().eq('session_id', sessionId).eq('key', key)
      : table().upsert({ session_id: sessionId, key, value: encode(value) }, { onConflict: 'session_id,key' })
    const { error } = await query
    if (error) throw error
  }
  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => serialize(async () => {
          const values = {}
          for (const id of ids) {
            let value = await read(`${type}-${id}`)
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
            values[id] = value
          }
          return values
        }),
        set: data => serialize(async () => {
          for (const [category, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values)) await write(`${category}-${id}`, value)
          }
        })
      }
    },
    saveCreds: () => serialize(() => write('creds', creds))
  }
}
