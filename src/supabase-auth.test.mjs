import test from 'node:test'
import assert from 'node:assert/strict'
import { useSupabaseAuthState } from './supabase-auth.mjs'

function database() {
  const rows = new Map()
  return { from() {
    const filters = {}
    return {
      select() { return this }, eq(key, value) { filters[key] = value; return this },
      async maybeSingle() { const value = rows.get(`${filters.session_id}/${filters.key}`); return { data: value ? { value } : null, error: null } },
      async upsert(row) { rows.set(`${row.session_id}/${row.key}`, row.value); return { error: null } },
      delete() { return { eq(key, value) { filters[key] = value; return this }, then(resolve) { rows.delete(`${filters.session_id}/${filters.key}`); resolve({ error: null }) } } }
    }
  } }
}
test('preserva credenciais e chaves da sessão no banco', async () => {
  const db = database()
  const first = await useSupabaseAuthState(db, 'test')
  await first.saveCreds()
  await first.state.keys.set({ session: { player: Buffer.from('secret') } })
  const restored = await useSupabaseAuthState(db, 'test')
  assert.deepEqual(restored.state.creds.noiseKey, first.state.creds.noiseKey)
  assert.deepEqual((await restored.state.keys.get('session', ['player'])).player, Buffer.from('secret'))
  await restored.state.keys.set({ session: { player: null } })
  assert.equal((await restored.state.keys.get('session', ['player'])).player, null)
})
