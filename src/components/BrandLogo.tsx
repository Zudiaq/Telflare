import React from 'react';

interface BrandLogoProps {
  className?: string;
  imageClassName?: string;
  alt?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  className = '',
  imageClassName = '',
  alt = 'Telflare'
}) => (
  <span className={`brand-logo relative inline-flex items-center justify-center ${className}`}>
    <img src="/cloud.svg" alt={alt} className={`brand-logo__image relative z-10 object-contain ${imageClassName}`} />
  </span>
);
