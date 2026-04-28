import { useEffect } from 'react';
import type { TrashedStock } from '../types';
import { TRASH_RETENTION_DAYS } from '../types';
import styles from './TrashModal.module.css';

interface Props {
  open: boolean;
  trashed: TrashedStock[];
  onClose: () => void;
  onRestore: (id: string) => void | Promise<void>;
  onPurge: (id: string) => void | Promise<void>;
}

function formatDate(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function daysLeft(expiresAt: number) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

export default function TrashModal({ open, trashed, onClose, onRestore, onPurge }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>
            🗑️ 휴지통
            <span className={styles.count}>{trashed.length}</span>
          </h3>
          <button className={styles.closeBtn} onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className={styles.hint}>
          삭제된 종목은 {TRASH_RETENTION_DAYS}일 동안 보관되며, 이후 자동으로 영구 삭제됩니다.
        </div>

        {trashed.length === 0 ? (
          <div className={styles.empty}>휴지통이 비어 있습니다.</div>
        ) : (
          <div className={styles.list}>
            {trashed.map((t) => {
              const left = daysLeft(t.expiresAt);
              const urgent = left <= 3;
              return (
                <div key={t.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <div className={styles.nameLine}>
                      <span className={styles.name}>{t.name}</span>
                      {t.code && <span className={styles.code}>({t.code})</span>}
                    </div>
                    <div className={styles.metaLine}>
                      <span className={styles.meta}>삭제 {formatDate(t.deletedAt)}</span>
                      <span className={`${styles.daysLeft} ${urgent ? styles.daysUrgent : ''}`}>
                        {left > 0 ? `영구삭제까지 ${left}일` : '영구삭제 임박'}
                      </span>
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <button
                      className={styles.restoreBtn}
                      onClick={() => onRestore(t.id)}
                      title="이 종목을 복원합니다"
                    >
                      ↩ 복원
                    </button>
                    <button
                      className={styles.purgeBtn}
                      onClick={() => {
                        if (confirm(`"${t.name}" 종목을 영구 삭제하시겠습니까?\n복원이 불가능합니다.`)) {
                          onPurge(t.id);
                        }
                      }}
                      title="영구 삭제 (복원 불가)"
                    >
                      🗑 영구삭제
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
