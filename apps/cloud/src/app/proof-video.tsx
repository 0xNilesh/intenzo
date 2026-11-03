"use client";

import { useEffect, useRef } from "react";

// The hero's recording. It plays on its own, muted and looping, unless the visitor asked for less
// motion: then it stays on its poster with controls.
export function ProofVideo({ src, poster, label }: { src: string; poster: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (still.matches) {
      video.removeAttribute("autoplay");
      video.controls = true;
      video.pause();
    } else {
      void video.play().catch(() => (video.controls = true));
    }
  }, []);
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      aria-label={label}
    />
  );
}
