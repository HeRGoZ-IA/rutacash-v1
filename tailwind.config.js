/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50:  '#FFF1F2',
          100: '#FFE4E6',
          200: '#FECDD3',
          300: '#FDA4AF',
          400: '#FB7185',
          500: '#F43F5E',
          600: '#D71920',
          700: '#9F1117',
          800: '#7A0B10',
          900: '#1F0A0C',
          950: '#0F0506',
        },
        finance: {
          green: '#10b981',
          'green-light': '#d1fae5',
          red: '#ef4444',
          'red-light': '#fee2e2',
          yellow: '#f59e0b',
          'yellow-light': '#fef3c7',
          orange: '#f97316',
          'orange-light': '#ffedd5',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06)',
        modal: '0 20px 60px rgba(0,0,0,0.15)',
      },
    },
  },
  plugins: [],
}
