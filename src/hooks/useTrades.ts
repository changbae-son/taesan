import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Trade } from '../types';

export function useTrades() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'trades'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const list: Trade[] = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Trade[];
      setTrades(list);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const addTrade = useCallback(async (trade: Omit<Trade, 'id' | 'createdAt'>) => {
    const id = `trade_${Date.now()}`;
    await setDoc(doc(db, 'trades', id), {
      ...trade,
      createdAt: Date.now(),
    });
    return id;
  }, []);

  const updateTrade = useCallback(async (trade: Trade) => {
    const { id, ...data } = trade;
    await setDoc(doc(db, 'trades', id), data);
  }, []);

  const removeTrade = useCallback(async (id: string) => {
    await deleteDoc(doc(db, 'trades', id));
  }, []);

  return { trades, loading, addTrade, updateTrade, removeTrade };
}
