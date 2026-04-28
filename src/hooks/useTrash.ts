import { useEffect, useState, useCallback } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { TrashedStock, Stock } from '../types';

export function useTrash() {
  const [trashed, setTrashed] = useState<TrashedStock[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'stocks_trash'), orderBy('deletedAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: TrashedStock[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<TrashedStock, 'id'>),
        }));
        setTrashed(list);
        setLoading(false);
      },
      (err) => {
        console.warn('Trash subscription error:', err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  // 휴지통 → stocks 로 복원
  const restore = useCallback(async (id: string) => {
    const ref = doc(db, 'stocks_trash', id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data() as Record<string, unknown> & {
      originalId?: string;
    };
    const restoreId = data.originalId || id;
    const stockData: Record<string, unknown> = { ...data };
    delete stockData.deletedAt;
    delete stockData.expiresAt;
    delete stockData.originalId;
    stockData.updatedAt = Date.now();
    await setDoc(doc(db, 'stocks', restoreId), stockData as unknown as Omit<Stock, 'id'>);
    await deleteDoc(ref);
  }, []);

  // 영구 삭제
  const purge = useCallback(async (id: string) => {
    await deleteDoc(doc(db, 'stocks_trash', id));
  }, []);

  return { trashed, loading, restore, purge };
}
