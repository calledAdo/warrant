import { Dialog } from '@base-ui/react/dialog';
import { X } from '@/components/icons';
import type { ReactNode } from 'react';

export function Modal({ open, onOpenChange, title, description, children, busy = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; busy?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="dialog-popup">
      <Dialog.Close className="dialog-close" aria-label="Close dialog" disabled={busy}><X /></Dialog.Close>
      <Dialog.Title className="dialog-title">{title}</Dialog.Title>
      <Dialog.Description className="dialog-description">{description}</Dialog.Description>
      {children}
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
