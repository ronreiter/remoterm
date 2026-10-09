import { SIGN_IN_URL } from '../services'

export function SignIn() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold">Remoterm</h1>
      <p className="max-w-sm text-terminal-subtext">Open your terminal sessions from any browser.</p>
      <a
        href={SIGN_IN_URL}
        className="rounded-lg bg-terminal-accent px-5 py-3 font-medium text-terminal-bg"
        data-testid="signin-link"
      >
        Sign in with GitHub
      </a>
    </main>
  )
}
