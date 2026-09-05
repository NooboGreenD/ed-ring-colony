import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'bg': '#1e2022',
        'panel': '#2a2d30',
        'panel-hover': '#323538',
        'line': '#3a3d40',
        'text': '#eeeeee',
        'muted': '#9ca3af',
        'orange': '#e67e22',
        'orange-hover': '#f39c12',
        'cyan': '#3498db',
        'green': '#2ecc71',
        'red': '#e74c3c',
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
export default config
