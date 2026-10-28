import net from 'node:net';

/**
 * Node intenta IPv6/IPv4 en paralelo ("happy eyeballs") con 250 ms por intento. Con proveedores
 * lejanos (p. ej. el OSRM demo en Alemania visto desde Sudamérica) el handshake TCP supera ese
 * tiempo y fetch falla con ETIMEDOUT aunque el servidor responda. 2 s por intento lo evita.
 */
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
