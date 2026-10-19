// Tema de CLEAN sin copiarlo: se importa su tailwind.config.js. Solo cambia dónde se
// buscan las clases (las pantallas originales de ../src y el puente de online/src).
import clean from '../tailwind.config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  ...clean,
  content: [
    path.join(here, 'index.html'),
    path.join(here, 'src/bridge/**/*.{ts,tsx}'),
    path.join(here, 'src/runtime/**/*.{ts,tsx}'),
    path.join(here, '../src/**/*.{ts,tsx}'),
  ],
};
