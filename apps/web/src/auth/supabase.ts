import { createClient, type User } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim();

export const estaSupabaseConfigurado = Boolean(url && key);
export const supabase = estaSupabaseConfigurado ? createClient(url!, key!) : null;

export async function iniciarSesionSupabase(email: string, password: string): Promise<User> {
  if (!supabase) throw new Error('Falta configurar Supabase en las variables VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw error ?? new Error('Supabase no devolvió el usuario.');
  return data.user;
}

export async function solicitarRecuperacion(email: string): Promise<void> {
  if (!supabase) throw new Error('Supabase no está configurado.');
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw error;
}

export async function cerrarSesionSupabase(): Promise<void> {
  await supabase?.auth.signOut();
}

export async function tokenSupabase(): Promise<string | undefined> {
  if (!supabase) return undefined;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export async function leerPerfilSupabase(userId: string): Promise<string | undefined> {
  if (!supabase) return undefined;
  const { data, error } = await supabase.from('perfiles').select('nombre').eq('id', userId).maybeSingle();
  if (error) throw error;
  return typeof data?.nombre === 'string' ? data.nombre : undefined;
}
