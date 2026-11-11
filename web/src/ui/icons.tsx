import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...p });

export const IconPack = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="5" y="2.5" width="14" height="19" rx="2" />
    <path d="M5 6.5h14M5 17.5h14M12 9.2l1 2 2.1.3-1.5 1.5.3 2.1-1.9-1-1.9 1 .3-2.1-1.5-1.5 2.1-.3z" />
  </svg>
);
export const IconCoin = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5l1.3 2.7 3 .4-2.2 2.1.6 3-2.7-1.5-2.7 1.5.6-3-2.2-2.1 3-.4z" />
  </svg>
);
export const IconDollar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M14.8 9.2c-.4-1-1.4-1.6-2.8-1.6-1.6 0-2.8.8-2.8 2.1 0 3 5.8 1.4 5.8 4.5 0 1.300-1.300 2.200-3 2.200-1.500 0-2.600-.700-3-1.800M12 6v12" />
  </svg>
);
export const IconSound = ({ off, ...p }: SVGProps<SVGSVGElement> & { off?: boolean }) => (
  <svg {...base(p)}>
    <path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500z" />
    {off ? <path d="M16 9.500l5 5M21 9.500l-5 5" /> : <path d="M15.500 9a4.200 4.200 0 010 6M18 6.500a8 8 0 010 11" />}
  </svg>
);
export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 012-2h9" />
  </svg>
);
export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconShield = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3l7.500 3v5.500c0 4.500-3.200 8-7.500 9.500-4.300-1.500-7.500-5-7.500-9.500V6z" />
  </svg>
);
export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M14 5h5v5M19 5l-8 8M11 6H7a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-4" />
  </svg>
);
export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
export const IconBat = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 20l2.500-2.500M6.500 17.500l8-9.500c1.500-1.800 3.500-3.500 5-2s-.200 3.500-2 5l-9.500 8z" />
  </svg>
);
