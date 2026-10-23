import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

// Strava solo valida el dominio del redirect; la ruta /strava separa su ?code= del de Supabase Auth.
const STRAVA_REDIRECT = `${location.origin}/strava`

function connectStrava() {
  const state = crypto.randomUUID()
  sessionStorage.setItem('strava_state', state)
  const url = new URL('https://www.strava.com/oauth/authorize')
  url.search = new URLSearchParams({
    client_id: import.meta.env.VITE_STRAVA_CLIENT_ID,
    redirect_uri: STRAVA_REDIRECT,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state,
  }).toString()
  location.assign(url)
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  // Vuelta de Strava: validar state y scope, y canjear el code en la Edge Function.
  useEffect(() => {
    if (!session || location.pathname !== '/strava') return
    const p = new URLSearchParams(location.search)
    history.replaceState(null, '', '/')
    const expected = sessionStorage.getItem('strava_state')
    sessionStorage.removeItem('strava_state')
    const code = p.get('code')
    if (!expected || p.get('state') !== expected) return setMsg('Estado OAuth inválido, vuelve a conectar')
    if (!code) return setMsg('Acceso a Strava denegado')
    if (!p.get('scope')?.split(',').includes('activity:read_all')) {
      return setMsg('Hace falta el permiso de ver todas las actividades')
    }
    setMsg('Conectando Strava…')
    supabase.functions
      .invoke('strava-oauth', { body: { code } })
      .then(({ data, error }) => setMsg(error ? `Error: ${error.message}` : `Strava conectado: ${data.athlete}`))
  }, [session])

  async function sendLink(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin },
    })
    setMsg(error ? `Error: ${error.message}` : 'Revisa tu correo')
  }

  if (!session) {
    return (
      <main>
        <h1>UpStat</h1>
        <form onSubmit={sendLink}>
          <label>
            Email <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button>Enviar enlace</button>
        </form>
        <p role="status">{msg}</p>
      </main>
    )
  }

  return (
    <main>
      <h1>UpStat</h1>
      <p>{session.user.email}</p>
      <button onClick={connectStrava}>Conectar Strava</button>
      <button onClick={() => supabase.auth.signOut()}>Salir</button>
      <p role="status">{msg}</p>
    </main>
  )
}
