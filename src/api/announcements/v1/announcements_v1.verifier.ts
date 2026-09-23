import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V, pageQueryFields, UUID_REGEX } from "../../common/common_v1.verifier";

// Contratos del recurso announcements (schema communication): comunicados de
// la administración a los residentes y los grupos de audiencia con los que se
// elige a quién van.
//
// TOPES DE NEGOCIO, no de integridad: la BD no conoce ninguno de estos
// números (mismo criterio que VISIT_MAX_VALIDITY_DAYS). El título cabe en una
// línea de lista; el cuerpo es un aviso de condominio, no un reglamento
// entero — el reglamento va de adjunto.
const TITLE_MAX = 140;
const BODY_MAX = 10_000;
const MAX_FILES = 10;

/** Tipos de persona del padrón (community.member_type). Espejo del enum: un
 *  valor inventado lo rechazaría la BD, pero con un 400 claro se ve antes. */
const MEMBER_TYPES = ["owner", "tenant", "resident"] as const;

// --- Entrada: crear comunicado ----------------------------------------------
export const createAnnouncementV1V = new V.ObjectNotNull(
    {
        title: new V.StringNotNull({ minLength: 1, maxLength: TITLE_MAX }),
        body: new V.StringNotNull({ minLength: 1, maxLength: BODY_MAX }),
        // null = "Todos" (no hay grupo comodín; ver 06_communication_tables.sql).
        audienceGroupId: new V.String({ regex: UUID_REGEX }),
        isPinned: new V.Boolean({ defaultValue: false }),
        /** Ids de storage-service ya subidos por la SPA con el Bearer del usuario. */
        fileIds: new V.Array(new V.StringNotNull({ regex: UUID_REGEX }), { maxLength: MAX_FILES }),
    },
    { strictMode: true },
);

// --- Entrada: editar comunicado ---------------------------------------------
// La audiencia solo se admite en BORRADOR (lo impone el controller, no este
// contrato: aquí no se sabe en qué estado está la fila).
export const updateAnnouncementV1V = new V.ObjectNotNull(
    {
        title: new V.String({ minLength: 1, maxLength: TITLE_MAX }),
        body: new V.String({ minLength: 1, maxLength: BODY_MAX }),
        audienceGroupId: new V.String({ regex: UUID_REGEX }),
        isPinned: new V.Boolean(),
        fileIds: new V.Array(new V.StringNotNull({ regex: UUID_REGEX }), { maxLength: MAX_FILES }),
    },
    { strictMode: true },
);

// --- Entrada: listar comunicados --------------------------------------------
export const listAnnouncementsQueryV1V = new V.ObjectNotNull(
    {
        ...pageQueryFields(),
        publicationStatus: new V.String({ in: ["draft", "published", "archived"] }),
        q: new V.String({ maxLength: 100 }),
    },
    { strictMode: true },
);

// --- Entrada: listar lecturas -----------------------------------------------
export const listReadersQueryV1V = new V.ObjectNotNull(
    {
        ...pageQueryFields(),
        filter: new V.String({ in: ["read", "unread"] }),
    },
    { strictMode: true },
);

// --- Entrada: grupos de audiencia -------------------------------------------
export const createAudienceGroupV1V = new V.ObjectNotNull(
    {
        name: new V.StringNotNull({ minLength: 1, maxLength: 100 }),
        description: new V.String({ maxLength: 500 }),
        // Los dos criterios son opcionales y se combinan con Y; omitirlos los
        // dos sería "Todos", que NO es un grupo — lo rechaza el controller con
        // un mensaje, y detrás está el CHECK de la BD.
        memberTypes: new V.Array(new V.StringNotNull({ in: [...MEMBER_TYPES] }), { minLength: 1 }),
        towers: new V.Array(new V.StringNotNull({ minLength: 1, maxLength: 50 }), { minLength: 1 }),
    },
    { strictMode: true },
);

export const updateAudienceGroupV1V = new V.ObjectNotNull(
    {
        name: new V.String({ minLength: 1, maxLength: 100 }),
        description: new V.String({ maxLength: 500 }),
        memberTypes: new V.Array(new V.StringNotNull({ in: [...MEMBER_TYPES] }), { minLength: 1 }),
        towers: new V.Array(new V.StringNotNull({ minLength: 1, maxLength: 50 }), { minLength: 1 }),
        status: new V.String({ in: ["active", "inactive"] }),
    },
    { strictMode: true },
);

export const listAudienceGroupsQueryV1V = new V.ObjectNotNull(
    {
        ...pageQueryFields(),
        status: new V.String({ in: ["active", "inactive"] }),
    },
    { strictMode: true },
);

/** Vista previa de una regla ANTES de guardarla: listas separadas por comas
 *  para que quepan en un querystring (`?memberTypes=owner,tenant&towers=A,B`). */
export const audiencePreviewQueryV1V = new V.ObjectNotNull(
    {
        memberTypes: new V.String({ maxLength: 200 }),
        towers: new V.String({ maxLength: 500 }),
    },
    { strictMode: true },
);

// --- Salida: comunicado ------------------------------------------------------
const announcementFieldsV1V = {
    id: new V.StringNotNull(),
    communityId: new V.StringNotNull(),
    title: new V.StringNotNull(),
    excerpt: new V.StringNotNull(),
    publicationStatus: new V.StringNotNull(),
    isPinned: new V.BooleanNotNull(),
    audienceGroupId: new V.String(),
    /** null = "Todos": no hay etiqueta porque no hay grupo. */
    audienceLabel: new V.String(),
    audienceMemberTypes: new V.Array(new V.StringNotNull()),
    audienceTowers: new V.Array(new V.StringNotNull()),
    publishedAt: new V.String(),
    editedAt: new V.String(),
    archivedAt: new V.String(),
    readCount: new V.NumberNotNull(),
    audienceAccounts: new V.NumberNotNull(),
    audiencePeople: new V.NumberNotNull(),
    fileCount: new V.NumberNotNull(),
    status: new V.StringNotNull(),
    createdAt: new V.StringNotNull(),
    updatedAt: new V.StringNotNull(),
};

export const announcementV1V = new V.ObjectNotNull(announcementFieldsV1V);

export const announcementFileV1V = new V.ObjectNotNull({
    id: new V.StringNotNull(),
    filename: new V.StringNotNull(),
    contentType: new V.StringNotNull(),
    sizeBytes: new V.NumberNotNull(),
    sortOrder: new V.NumberNotNull(),
});

export const announcementDetailV1V = new V.ObjectNotNull({
    ...announcementFieldsV1V,
    body: new V.StringNotNull(),
    files: new V.ArrayNotNull(announcementFileV1V),
});

export const announcementListV1V = new V.ObjectNotNull({
    items: new V.ArrayNotNull(announcementV1V),
    total: new V.NumberNotNull(),
    page: new V.NumberNotNull(),
    pageSize: new V.NumberNotNull(),
});

// --- Salida: lecturas --------------------------------------------------------
export const announcementReaderV1V = new V.ObjectNotNull({
    userId: new V.StringNotNull(),
    fullName: new V.StringNotNull(),
    /** Domicilios de esa persona en la comunidad, ya juntos ("426-A, 512-B"). */
    homes: new V.StringNotNull(),
    readAt: new V.String(),
});

export const announcementReaderListV1V = new V.ObjectNotNull({
    items: new V.ArrayNotNull(announcementReaderV1V),
    total: new V.NumberNotNull(),
    page: new V.NumberNotNull(),
    pageSize: new V.NumberNotNull(),
});

// --- Salida: grupos ----------------------------------------------------------
export const audienceGroupV1V = new V.ObjectNotNull({
    id: new V.StringNotNull(),
    communityId: new V.StringNotNull(),
    name: new V.StringNotNull(),
    description: new V.String(),
    memberTypes: new V.Array(new V.StringNotNull()),
    towers: new V.Array(new V.StringNotNull()),
    /** Las dos cifras de alcance de la regla, al vuelo. */
    people: new V.NumberNotNull(),
    accounts: new V.NumberNotNull(),
    status: new V.StringNotNull(),
    createdAt: new V.StringNotNull(),
    updatedAt: new V.StringNotNull(),
});

export const audienceGroupListV1V = new V.ObjectNotNull({
    items: new V.ArrayNotNull(audienceGroupV1V),
    total: new V.NumberNotNull(),
    page: new V.NumberNotNull(),
    pageSize: new V.NumberNotNull(),
    /** Las torres que EXISTEN hoy en la comunidad (el selector del formulario). */
    towers: new V.ArrayNotNull(new V.StringNotNull()),
});

export const audiencePreviewV1V = new V.ObjectNotNull({
    people: new V.NumberNotNull(),
    accounts: new V.NumberNotNull(),
});

// --- Salida: enlace firmado de un adjunto ------------------------------------
export const announcementFileLinkV1V = new V.ObjectNotNull({
    url: new V.StringNotNull(),
    expiresAt: new V.StringNotNull(),
    filename: new V.StringNotNull(),
    contentType: new V.StringNotNull(),
});

/** Params de un adjunto: /communities/:communityId/announcements/:id/files/:fileId/link */
export const announcementFileParamV1V = new V.ObjectNotNull(
    {
        communityId: new V.StringNotNull({ regex: UUID_REGEX }),
        id: new V.StringNotNull({ regex: UUID_REGEX }),
        fileId: new V.StringNotNull({ regex: UUID_REGEX }),
    },
    { strictMode: true },
);

export { errorResponseV1V };
