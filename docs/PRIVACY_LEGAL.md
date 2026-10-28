# Privacidad e implicaciones legales

> Este documento describe cómo el sistema implementa la privacidad. **No es asesoramiento legal.** Antes de usarlo con terceros (empleados, clientes, menores), revisalo con un profesional según tu jurisdicción. En Argentina aplica la Ley 25.326 de Protección de Datos Personales (y la AAIP como autoridad); en la UE, el RGPD.

## Qué hace el sistema

| Principio | Implementación |
|---|---|
| Consentimiento explícito | Pantalla de privacidad en la app con aceptación y versión del texto (`device_consents`). Sin consentimiento vigente el servidor rechaza la ingesta (`403 CONSENT_REQUIRED`) |
| Lo otorga el titular | Solo quien lleva el teléfono puede otorgar o revocar su consentimiento. Un admin no puede hacerlo por él |
| Compartir es opcional | `share_with_org`: sin esa opción, los demás miembros de la organización no ven los datos (ni siquiera la existencia del dispositivo: responde 404) |
| Seguimiento visible | Notificación persistente en Android e indicador azul en iOS. No hay modo oculto ni evasión de permisos |
| Revocable | El titular revoca en la app. Titular o admin pueden revocar el dispositivo desde la web |
| Minimización | Solo los datos de ubicación necesarios y el nivel de batería. Sin contactos ni identificadores publicitarios |
| Retención limitada | 90 días por defecto, configurable por organización (1–3650). Borrado automático diario |
| Derecho de acceso y portabilidad | Exportación de los datos propios (`/v1/me/export`), más exportaciones por recorrido |
| Derecho de supresión | Eliminar un dispositivo borra todo su historial. Eliminar la cuenta borra en cascada (por ahora solo por base de datos o soporte: no hay endpoint, ver pendientes) |
| Auditoría | Registro de vistas de recorridos, exportaciones, revocaciones y cambios de miembros (sin coordenadas). Se conserva 365 días |
| Seguridad | HTTPS; contraseñas con Argon2id; refresh tokens rotativos con detección de robo; tokens de dispositivo separados y revocables; logs sin coordenadas ni secretos |

## Uso con empleados o terceros

- El seguimiento laboral suele exigir **información previa clara, una finalidad legítima y proporcionalidad**: por ejemplo, solo en horario laboral y en vehículos de la empresa. El consentimiento de un empleado puede no considerarse libre: evaluá otra base legal y documentá la finalidad.
- No registres fuera del horario o de la finalidad informada: usá sesiones de seguimiento acotadas y una retención corta.
- Informá quién accede a los datos (roles), cuánto tiempo se guardan y cómo ejercer los derechos de acceso, rectificación y supresión.
- No uses el sistema para vigilar a personas que no saben que se las rastrea. El diseño lo impide técnicamente: el titular controla el teléfono, el consentimiento y la revocación.

## Distribución en tiendas
- **Google Play** exige declarar el uso de la ubicación en segundo plano y justificarlo (formulario de permisos sensibles y video). El texto de la app explica el uso.
- **App Store** revisa que "Permitir siempre" tenga un propósito claro, coherente con los textos de `NSLocation*UsageDescription`.
