import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Snapshot } from '../types';

export function useSnapshots() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);

  useEffect(() => {
    const q = query(collection(db, 'snapshots'), orderBy('createdAt', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const list: Snapshot[] = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Snapshot[];
      setSnapshots(list);
    }, (err) => {
      console.warn('Snapshots subscription error:', err);
    });
    return () => unsub();
  }, []);

  const addSnapshot = useCallback(
    async (stockId: string, stockName: string, profitPercent: number) => {
      const id = `snap_${Date.now()}`;
      const today = new Date().toISOString().slice(0, 10);
      await setDoc(doc(db, 'snapshots', id), {
        stockId,
        stockName,
        date: today,
        profitPercent,
        createdAt: Date.now(),
      });
    },
    []
  );

  return { snapshots, addSnapshot };
}
