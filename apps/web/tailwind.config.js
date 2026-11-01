/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#111318',
        surface: '#1B1F27',
        'surface-secondary': '#252A34',
        gold: '#D6B36A',
        'primary-text': '#F5F5F5',
        'secondary-text': '#A7AAB2',
        success: '#43B581',
        error: '#ED4245',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
