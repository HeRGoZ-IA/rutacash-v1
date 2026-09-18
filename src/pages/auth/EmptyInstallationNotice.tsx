import { Link } from 'react-router-dom'
import { Building2 } from 'lucide-react'

/**
 * INSTALACIÓN SIN EMPRESAS.
 *
 * Se muestra en `/login` cuando no existe ni un solo usuario de empresa: no hay
 * ninguna cuenta con la que se pueda entrar, así que un formulario de acceso solo
 * serviría para que alguien probara contraseñas contra la nada.
 *
 * Texto corto y operativo, sin pedagogía: dónde empieza todo y un enlace. El orden
 * real del onboarding es Owner → empresa → primer Super Admin → `/login`.
 */
export function EmptyInstallationNotice() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E3A8A] via-gray-900 to-[#1E3A8A] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <div className="w-11 h-11 bg-primary-500 rounded-2xl flex items-center justify-center">
            <span className="text-white font-bold text-lg">RC</span>
          </div>
          <div className="text-white">
            <p className="font-bold text-lg leading-tight">RutaCash</p>
            <p className="text-primary-300 text-xs">Sistema de rutas y cobros</p>
          </div>
        </div>

        <div className="bg-white rounded-3xl shadow-2xl p-8 text-center">
          <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto">
            <Building2 className="w-6 h-6 text-gray-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mt-4">Todavía no hay empresas</h1>
          <p className="text-sm text-gray-500 mt-2">
            Las empresas y su primer Super Admin se crean desde el portal de la
            plataforma. Después se entra por aquí con esas credenciales.
          </p>
          <Link to="/owner/login"
            className="mt-5 inline-flex h-11 px-5 items-center justify-center bg-gray-900 hover:bg-black text-white rounded-xl text-sm font-medium transition-colors">
            Ir al portal de la plataforma
          </Link>
        </div>
      </div>
    </div>
  )
}
