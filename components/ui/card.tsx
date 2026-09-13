import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// shadcn card structure from the user's 21st.dev integration prompt.
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('card', className)} {...props} />;
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('card-header', className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('card-title', className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('card-content', className)} {...props} />;
}
