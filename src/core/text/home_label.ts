// Cómo se le NOMBRA su domicilio al residente. El residente no dice "unidad":
// dice "mi casa", "mi departamento". Regla única, compartida con la SPA
// (`homeName` en features/me/domain/my-unit.ts): un domicilio concreto se
// nombra por su TIPO + torre + código — "casa 426-A", "departamento Torre B
// 302" — y el genérico es "domicilio".
//
// SOLO para superficies del residente (avisos push). Todo lo administrativo
// (rutas /communities/..., errores de operador, logs) sigue diciendo "unidad".
//
// Puro y sin dependencias, para poder probarlo sin red ni BD.

/** Espejo de `UNIT_TYPE_LABELS` de la SPA (community.unit_type), en minúscula:
 *  aquí el nombre siempre va en medio de una frase ("va a tu casa 426-A"). */
const UNIT_TYPE_LABELS: Readonly<Record<string, string>> = {
    apartment: "departamento",
    house: "casa",
    lot: "lote",
    commercial_local: "local comercial",
    parking: "estacionamiento",
    storage: "bodega",
};

/** Genérico para un tipo que este servicio todavía no conoce (enum ampliado en
 *  BD antes que aquí): mejor "domicilio 12" que un código crudo en inglés. */
const FALLBACK_LABEL = "domicilio";

export interface HomeLabelInput {
    readonly unitType: string;
    readonly unitTower: string | null;
    readonly unitCode: string;
}

/** `casa 426-A` · `departamento Torre B 302` · `lote 15`. */
export function homeLabel(home: HomeLabelInput): string {
    const type = UNIT_TYPE_LABELS[home.unitType] ?? FALLBACK_LABEL;
    const tower = home.unitTower?.trim() ?? "";
    return tower === "" ? `${type} ${home.unitCode}` : `${type} ${tower} ${home.unitCode}`;
}
