// 3.37 · «Ver detalle» en las tarjetas de Rutas. En CLEAN (motor local) no existe el panel de rutas del servidor:
// no muestra nada. ADEX Online lo sustituye por `online/src/bridge/components/routes/RouteDetailButton.tsx`, que abre
// la MISMA ventana de detalle de ruta de Caja principal.
export function RouteDetailButton(_props: { routeId: string }) {
  return null
}
