/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        drive: {
          bg: '#f8fafd',
          darkbg: '#131314',
          surface: '#ffffff',
          darksurface: '#1e1f20',
          hover: '#f0f4f9',
          darkhover: '#282a2c',
          text: '#1f1f1f',
          darktext: '#e3e3e3',
          icon: '#444746',
          darkicon: '#c4c7c5',
          primary: '#57687D',
          darkprimary: '#7c92a6',
        },
        blue: {
          50: '#f5f6f8',
          100: '#e5e9ec',
          200: '#ccd4dc',
          300: '#a3b6c3',
          400: '#7c92a6',
          500: '#57687D',
          600: '#48586c',
          700: '#3b4859',
          800: '#323d4a',
          900: '#2b333e',
          950: '#1b2028',
        }
      },
      fontFamily: {
        sans: ['Inter', 'Vazirmatn', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        vazir: ['Vazirmatn', 'sans-serif'],
      }
    },
  },
  plugins: [
    require('tailwindcss-animate')
  ],
}
