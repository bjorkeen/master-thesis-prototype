/**
 * useWebSocket.ts — Connects to the Socket.io gateway and listens for events.
 *
 * The gateway broadcasts "twin:state_update" every 5 seconds.
 * This hook subscribes to that event and keeps the latest twin state in React state.
 *
 * Usage in a component:
 *   const { twinState, connected } = useWebSocket();
 */

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { TwinState } from '../types';

const GATEWAY_URL = 'http://localhost:4000';

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);

  // `connected` is true while the Socket.io connection is live
  const [connected, setConnected] = useState(false);

  // Latest twin state pushed from the gateway
  const [twinState, setTwinState] = useState<TwinState | null>(null);

  useEffect(() => {
    // Create the Socket.io connection once on mount
    const socket = io(GATEWAY_URL, {
      transports: ['websocket'],   // skip polling for lower latency
      reconnectionDelay: 2000,     // wait 2 s before reconnecting
    });

    socketRef.current = socket;

    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    // Gateway sends this every 5 seconds — update our state when it arrives
    socket.on('twin:state_update', (data: TwinState) => {
      setTwinState(data);
    });

    // Clean up when the component that uses this hook unmounts
    return () => {
      socket.disconnect();
    };
  }, []); // empty deps — runs once on mount

  return { twinState, connected, socket: socketRef.current };
}
