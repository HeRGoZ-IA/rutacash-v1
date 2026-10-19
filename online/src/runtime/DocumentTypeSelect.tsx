// ADEX Online: tipo de documento del cliente (DS-10).
//
// CLEAN solo pide el número; el servidor exige además el TIPO del catálogo del país de la
// empresa (cédula, cédula de extranjería, PPT, CPF…), porque la unicidad y la validación
// del número dependen de él. Es el único campo que se añade a los formularios originales
// de alta de cliente, con el mismo componente `Select` de CLEAN. Por defecto, el documento
// personal habitual del país (se puede cambiar).

import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/Input';
import { serverView } from './projection.ts';
import { useRuntime } from './session.ts';

interface DocumentType { code: string; label: string }

const DEFAULT_BY_COUNTRY: Record<string, string> = { CO: 'CC', BR: 'CPF' };

export function defaultDocumentType(): string {
  return DEFAULT_BY_COUNTRY[useRuntime.getState().ctx?.company.countryCode ?? ''] ?? '';
}

export function DocumentTypeSelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [types, setTypes] = useState<DocumentType[]>([]);
  useEffect(() => {
    let alive = true;
    serverView<{ documentTypes: DocumentType[] }>('/v1/document-types')
      .then((r) => {
        if (!alive) return;
        setTypes(r.documentTypes ?? []);
        if (!value && r.documentTypes?.length) onChange(defaultDocumentType() || r.documentTypes[0]!.code);
      })
      .catch(() => { /* sin catálogo: el servidor rechazará el alta con su motivo */ });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Select label="Tipo de documento" value={value} onChange={(e) => onChange(e.target.value)}
      options={types.map((t) => ({ value: t.code, label: t.label }))} required />
  );
}
