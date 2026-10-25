import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

type Activity = {
  id: number
  sport_type: string
  start_at: string
  duration_s: number | null
  distance_m: number | null
}

type Day = {
  date: string
  steps: number | null
  active_kcal: number | null
  resting_hr: number | null
  hrv_ms: number | null
  sleep_min: number | null
}

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
  const [activities, setActivities] = useState<Activity[]>([])
  const [days, setDays] = useState<Day[]>([])

  async function loadActivities() {
    const { data, error } = await supabase
      .from('activities')
      .select('id, sport_type, start_at, duration_s, distance_m')
      .order('start_at', { ascending: false })
      .limit(50)
    if (error) setMsg(`Error: ${error.message}`)
    else setActivities(data)
    const health = await supabase
      .from('daily_health')
      .select('date, steps, active_kcal, resting_hr, hrv_ms, sleep_min')
      .order('date', { ascending: false })
      .limit(14)
    if (health.error) setMsg(`Error: ${health.error.message}`)
    else setDays(health.data)
  }

  // Repite strava-sync hasta que no queden actividades (cada llamada trae ~1000 como máximo).
  async function syncStrava() {
    let total = 0
    for (;;) {
      setMsg(`Sincronizando Strava… ${total} actividades`)
      const { data, error } = await supabase.functions.invoke('strava-sync')
      if (error) return setMsg(`Error: ${error.message}`)
      total += data.imported
      if (data.rateLimited) {
        setMsg(`${total} actividades. Límite de Strava alcanzado, vuelve a sincronizar en 15 min`)
        break
      }
      if (data.done) {
        setMsg(`Sincronizado: ${total} actividades nuevas`)
        break
      }
    }
    loadActivities()
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session) loadActivities()
  }, [session])

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
      <button onClick={syncStrava}>Sincronizar Strava</button>
      <button onClick={() => supabase.auth.signOut()}>Salir</button>
      <p role="status">{msg}</p>
      <h2>Salud</h2>
      <table>
        <thead>
          <tr><th>Día</th><th>Pasos</th><th>kcal activas</th><th>FC reposo</th><th>VFC</th><th>Sueño</th></tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{new Date(d.date).toLocaleDateString('es-ES', { timeZone: 'UTC', dateStyle: 'medium' })}</td>
              <td>{d.steps ?? '—'}</td>
              <td>{d.active_kcal == null ? '—' : Math.round(d.active_kcal)}</td>
              <td>{d.resting_hr ?? '—'}</td>
              <td>{d.hrv_ms == null ? '—' : `${Math.round(d.hrv_ms)} ms`}</td>
              <td>{d.sleep_min == null ? '—' : `${Math.floor(d.sleep_min / 60)}h ${d.sleep_min % 60}min`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Actividades</h2>
      <table>
        <thead>
          <tr><th>Fecha</th><th>Deporte</th><th>Distancia</th><th>Duración</th></tr>
        </thead>
        <tbody>
          {activities.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.start_at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td>{a.sport_type}</td>
              <td>{a.distance_m ? `${(a.distance_m / 1000).toFixed(2)} km` : '—'}</td>
              <td>{a.duration_s ? `${Math.floor(a.duration_s / 3600)}h ${Math.floor((a.duration_s % 3600) / 60)}min` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
