# Pruebas de la app móvil en dispositivos físicos

> **Estado: PENDIENTES.** No se ejecutaron porque el entorno de desarrollo no tuvo emulador ni teléfono. Hasta completar esta lista, la captura en segundo plano se considera **no verificada**.
>
> Sí está verificado: los tipos de TypeScript, el bundle de Metro para Android, el `expo prebuild` con permisos correctos y la lógica de captura, cola y sincronización (pruebas con SQLite real y simulación de punta a punta contra la API).

Registrá en cada caso: dispositivo, versión del sistema, permiso otorgado, modo de captura, resultado y capturas de la web.

| # | Prueba | Pasos | Resultado esperado |
|---|---|---|---|
| 1 | Permisos | Instalar, iniciar sesión, aceptar consentimiento, iniciar seguimiento | Se pide "en uso" y después "siempre" (en Android 11+ abre Ajustes). Si se niega, la UI muestra el aviso y no registra nada |
| 2 | Indicador visible | Iniciar seguimiento y bloquear la pantalla | Android: notificación persistente "Registrando tu ubicación". iOS: indicador azul |
| 3 | Segundo plano | Seguimiento en modo Viaje y 30 min caminando o en auto con la pantalla bloqueada | En la web, un recorrido continuo sin huecos falsos y con detenciones detectadas |
| 4 | Sin conexión | Modo avión 10 min mientras se mueve, luego reconectar | Durante el corte los "pendientes" crecen. Al reconectar se envía todo, sin duplicados ni pérdidas, y la web muestra el tramo |
| 5 | Cierre forzado | Seguimiento activo, cerrar la app desde recientes y esperar 5 min en movimiento | Al reabrir: "Seguimiento interrumpido", reanudar o cerrar. En la web, un hueco marcado (`signal_gap`) y `capture_resumed` |
| 6 | Reinicio del teléfono | Seguimiento activo, reiniciar | Igual que el 5; la cola local se conserva |
| 7 | Revocar permiso | Quitar el permiso de ubicación en Ajustes con el seguimiento activo | La app muestra "Sin permiso" y no inventa posiciones |
| 8 | Revocar consentimiento | Privacidad → Revocar | Se detiene el seguimiento. El servidor responde 403 si se intentara enviar |
| 9 | Revocar desde la web | Dispositivos → Revocar | La app muestra "dispositivo revocado" y deja de enviar |
| 10 | Batería | 8 h en modo Normal y 8 h en modo Ahorro | Consumo razonable (registrar el % por hora) y menos puntos en Ahorro |
| 11 | Fabricantes agresivos | Xiaomi/Huawei/Samsung con optimización de batería activa | Documentar si el sistema mata el servicio (ver dontkillmyapp.com) |
| 12 | iOS "Permitir una vez" | Elegir "una vez" | Al volver a abrir, el permiso se pierde y la UI lo indica |
| 13 | Ubicación aproximada | Android 12+ o iOS sin "ubicación precisa" | Puntos con precisión baja (>100 m), marcados en la web |
| 14 | Geocercas reales | Crear una geocerca en la web, entrar y quedarse 2 min | Evento `geofence_enter` confirmado; un paso rápido por el borde no genera evento |
| 15 | Viaje real | Crear un viaje con ruta OSRM, iniciar desde la app, desviarse una cuadra | Avance, distancia restante y desvío confirmado en la app y en la web |
