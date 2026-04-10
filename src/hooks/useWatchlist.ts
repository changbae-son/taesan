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
import type { WatchItem } from '../types';

export function useWatchlist() {
  const [items, setItems] = useState<WatchItem[]>([]);

  useEffect(() => {
    const q = query(collection(db, 'watchlist'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const list: WatchItem[] = [];
      snap.forEach((d) => {
        list.push({ id: d.id, ...d.data() } as WatchItem);
      });
      setItems(list);
    });
    return unsub;
  }, []);

  const addItem = useCallback(async (name: string, code: string, peakPrice: number) => {
    const id = `watch_${Date.now()}`;
    const item: Omit<WatchItem, 'id'> = {
      name,
      code,
      peakPrice,
      targetPercent: -50,
      currentPrice: 0,
      openPrice: 0,
      prevClose: 0,
      status: 'watching',
      alertLevel: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await setDoc(doc(db, 'watchlist', id), item);
    return id;
  }, []);

  const removeItem = useCallback(async (id: string) => {
    await deleteDoc(doc(db, 'watchlist', id));
  }, []);

  const updateItem = useCallback(async (item: WatchItem) => {
    const { id, ...data } = item;
    await setDoc(doc(db, 'watchlist', id), { ...data, updatedAt: Date.now() });
  }, []);

  return { items, addItem, removeItem, updateItem };
}
