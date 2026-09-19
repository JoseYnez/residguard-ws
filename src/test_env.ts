// Entorno mínimo para las PRUEBAS UNITARIAS (se carga con --import antes que
// cualquier spec; ver el script `test`). `config.ts` valida el entorno al
// importarse y termina el proceso si falta algo, y los notifiers lo importan
// de forma transitiva (push_client) aunque sus funciones de texto sean puras.
// Aquí se rellenan SOLO las variables ausentes, con valores que no apuntan a
// nada: ninguna prueba unitaria sale a la red ni abre una conexión.

const TEST_DEFAULTS: Readonly<Record<string, string>> = {
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    AUTH_WS_BASE_URL: "http://127.0.0.1:1",
    ADMIN_WS_BASE_URL: "http://127.0.0.1:1",
    STORAGE_WS_BASE_URL: "http://127.0.0.1:1",
    STORAGE_API_KEY: "test",
};

for (const [key, value] of Object.entries(TEST_DEFAULTS)) {
    if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
    }
}
