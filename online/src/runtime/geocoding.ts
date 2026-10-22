// BÚSQUEDA POR DIRECCIÓN (Ronda 73 · SOC-06): punto de enganche, SIN proveedor.
//
// Convertir una dirección escrita en coordenadas exige un servicio de geocodificación externo. Ninguno
// está aprobado (claves, tarifas y condiciones de uso son decisión del propietario: ver
// docs/RONDA_73_CORRECCIONES_SOCIO.md, «SOC-06»). Mientras `geocoder` sea null, el mapa NO muestra el
// buscador y el Administrador ubica al cliente marcando y ajustando el punto a mano con la dirección
// escrita a la vista.
//
// Contrato para el proveedor que se elija: devolver candidatos con su precisión. El mapa los lista
// para elegir (direcciones ambiguas = varios candidatos), coloca un marcador PROVISIONAL que se
// corrige arrastrándolo y lo guarda solo tras confirmar, como «punto en el mapa» con una nota que
// dice que vino de una dirección (nunca como GPS confirmado).

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  /** Qué tan exacto es el candidato según el proveedor. */
  precision: 'rooftop' | 'street' | 'area';
}

export interface Geocoder {
  /** Nombre del proveedor (se muestra como atribución). */
  name: string;
  search(query: string, opts: { countryCode: string; near?: { lat: number; lng: number } }): Promise<GeocodeResult[]>;
}

/** Proveedor activo: ninguno hasta que el propietario elija uno. */
export const geocoder: Geocoder | null = null;

export const PRECISION_LABEL: Record<GeocodeResult['precision'], string> = {
  rooftop: 'número exacto', street: 'calle aproximada', area: 'zona aproximada',
};
