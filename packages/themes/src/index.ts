/** Structurally compatible with xterm's ITheme (kept local so this package has no dependencies). */
export interface TerminalTheme {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  selectionInactiveBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export type ThemeId = 'dark1' | 'dark2' | 'light'

export interface AppTheme {
  id: ThemeId
  name: string
  description: string
  terminal: TerminalTheme
  ui: {
    bg: string
    surface: string
    text: string
    subtext: string
    accent: string
    green: string
    red: string
    border: string
  }
}

export const THEMES: AppTheme[] = [
  {
    id: 'dark1',
    name: 'Catppuccin',
    description: 'Dark blue',
    terminal: {
      background: '#232334',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    },
    ui: {
      bg: '#1e1e2e',
      surface: '#313244',
      text: '#cdd6f4',
      subtext: '#a6adc8',
      accent: '#89b4fa',
      green: '#a6e3a1',
      red: '#f38ba8',
      border: '#45475a'
    }
  },
  {
    id: 'dark2',
    name: 'Midnight',
    description: 'Dark neutral',
    terminal: {
      background: '#121212',
      foreground: '#d4d4d4',
      cursor: '#e0e0e0',
      selectionBackground: '#3a3a3a',
      black: '#2a2a2a',
      red: '#f44747',
      green: '#6a9955',
      yellow: '#d7ba7d',
      blue: '#569cd6',
      magenta: '#c586c0',
      cyan: '#4ec9b0',
      white: '#cccccc',
      brightBlack: '#555555',
      brightRed: '#f44747',
      brightGreen: '#6a9955',
      brightYellow: '#d7ba7d',
      brightBlue: '#569cd6',
      brightMagenta: '#c586c0',
      brightCyan: '#4ec9b0',
      brightWhite: '#e0e0e0'
    },
    ui: {
      bg: '#121212',
      surface: '#1e1e1e',
      text: '#d4d4d4',
      subtext: '#808080',
      accent: '#569cd6',
      green: '#6a9955',
      red: '#f44747',
      border: '#2a2a2a'
    }
  },
  {
    id: 'light',
    name: 'Light',
    description: 'Light mode',
    terminal: {
      background: '#ffffff',
      foreground: '#1e1e1e',
      cursor: '#1e1e1e',
      selectionBackground: '#add6ff',
      black: '#1e1e1e',
      red: '#cd3131',
      green: '#008000',
      yellow: '#795e26',
      blue: '#0451a5',
      magenta: '#af00db',
      cyan: '#0598bc',
      white: '#d4d4d4',
      brightBlack: '#555555',
      brightRed: '#cd3131',
      brightGreen: '#008000',
      brightYellow: '#795e26',
      brightBlue: '#0451a5',
      brightMagenta: '#af00db',
      brightCyan: '#0598bc',
      brightWhite: '#1e1e1e'
    },
    ui: {
      bg: '#ffffff',
      surface: '#f3f3f3',
      text: '#1e1e1e',
      subtext: '#6e6e6e',
      accent: '#0451a5',
      green: '#008000',
      red: '#cd3131',
      border: '#e0e0e0'
    }
  }
]

export function getTheme(id: ThemeId): AppTheme {
  return THEMES.find((t) => t.id === id) || THEMES[0]
}
