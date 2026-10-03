import { API_ORIGIN } from './config'
import { ApiClient } from './lib/api'
import { TokenManager } from './lib/tokens'

const f: typeof fetch = (...args) => globalThis.fetch(...args)

export const tokens = new TokenManager(f, API_ORIGIN)
export const api = new ApiClient(tokens, f)
export const SIGN_IN_URL = `${API_ORIGIN}/auth/github?client=web`
