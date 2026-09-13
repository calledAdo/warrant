import { HugeiconsIcon, type HugeiconsProps, type IconSvgElement } from '@hugeicons/react';
import {
  ArrowRight01Icon, ArrowUpRight01Icon, Tick01Icon, CheckmarkCircle02Icon,
  Clock01Icon, Copy01Icon, CreditCardIcon, FileSearchIcon, File01Icon,
  GitBranchIcon, Loading03Icon, BubbleChatIcon, Mail01Icon, RefreshIcon,
  SecurityCheckIcon, UserIcon, Cancel01Icon, HelpCircleIcon, InboxIcon,
  DashboardSquare01Icon, Search01Icon, FilterHorizontalIcon, ReceiptDollarIcon,
} from '@hugeicons/core-free-icons';

// Only the free Stroke Rounded pack. Shared defaults keep every UI icon consistent.
function icon(data: IconSvgElement) {
  return function Icon(props: Omit<HugeiconsProps, 'icon'>) {
    return <HugeiconsIcon icon={data} size={20} strokeWidth={1.6} aria-hidden="true" focusable="false" {...props} />;
  };
}
export const ArrowRight = icon(ArrowRight01Icon);
export const ArrowUpRight = icon(ArrowUpRight01Icon);
export const Check = icon(Tick01Icon);
export const CheckCheck = icon(CheckmarkCircle02Icon);
export const Clock = icon(Clock01Icon);
export const Copy = icon(Copy01Icon);
export const CreditCard = icon(CreditCardIcon);
export const FileSearch = icon(FileSearchIcon);
export const FileText = icon(File01Icon);
export const GitBranch = icon(GitBranchIcon);
export const LoaderCircle = icon(Loading03Icon);
export const MessageSquare = icon(BubbleChatIcon);
export const Mail = icon(Mail01Icon);
export const RefreshCw = icon(RefreshIcon);
export const ShieldCheck = icon(SecurityCheckIcon);
export const UserRound = icon(UserIcon);
export const X = icon(Cancel01Icon);
export const CircleHelp = icon(HelpCircleIcon);
export const Inbox = icon(InboxIcon);
export const LayoutGrid = icon(DashboardSquare01Icon);
export const Search = icon(Search01Icon);
export const SlidersHorizontal = icon(FilterHorizontalIcon);
export const ReceiptText = icon(ReceiptDollarIcon);
