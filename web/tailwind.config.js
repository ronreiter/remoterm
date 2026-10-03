/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: 'var(--terminal-bg)',
          surface: 'var(--terminal-surface)',
          text: 'var(--terminal-text)',
          subtext: 'var(--terminal-subtext)',
          accent: 'var(--terminal-accent)',
          green: 'var(--terminal-green)',
          red: 'var(--terminal-red)',
          border: 'var(--terminal-border)'
        }
      }
    }
  },
  plugins: []
}
