import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return <svg className={cn('brand-mark', className)} viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="11" fill="currentColor" /><path d="m8 13 5 15 7-15 7 15 5-15" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function Brand({ href = '/' }: { href?: string }) {
  return <a className="brand" href={href} aria-label="Warrant home"><BrandMark /><span>warrant<span className="brand-period">.</span></span></a>;
}
