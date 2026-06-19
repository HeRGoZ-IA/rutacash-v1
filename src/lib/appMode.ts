export const APP_MODE = (import.meta.env.VITE_APP_MODE ?? 'demo') as 'demo' | 'clean'
export const IS_DEMO = APP_MODE === 'demo'
export const IS_CLEAN = APP_MODE === 'clean'
