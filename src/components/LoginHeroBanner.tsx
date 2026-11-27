import React from 'react';

interface LoginHeroBannerProps {
  isKeyboardOpen?: boolean;
}

const BRAND_LETTERS = ['S', 'm', 'a', 'r', 't', 'R', 'u', 'n'] as const;

export const LoginHeroBanner: React.FC<LoginHeroBannerProps> = ({ isKeyboardOpen = false }) => {
  return (
    <div
      id="login-hero-canva-bg"
      aria-label="SmartRun"
      className={`w-full max-w-md relative z-0 pointer-events-none select-none overflow-hidden bg-[#ffcc00] sm:rounded-b-3xl transition-[max-height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        isKeyboardOpen ? 'max-h-[120px] opacity-60' : 'max-h-[420px] opacity-100'
      }`}
    >
      {/* Preserves the exact aspect ratio and height of the hero box */}
      <div className="relative w-full pb-[calc(100%-76px)] overflow-hidden bg-[#ffcc00]">
        <div
          className={`absolute inset-0 flex items-center justify-center px-4 transition-transform duration-300 ${
            isKeyboardOpen ? 'pt-4' : 'pt-11 sm:pt-12'
          }`}
        >
          <div className="relative inline-flex items-center justify-center">
            {/* Echo Layer 2 (Canva Echo offset: 20 secondary trail in #c1ff72) */}
            <div
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center font-baloo font-extrabold tracking-[-0.025em] leading-none text-[3.15rem] sm:text-[3.5rem] text-[#c1ff72] login-echo-layer-2"
              style={{ fontFamily: "'Baloo 2', 'Baloo Bhai 2', 'Outfit', system-ui, sans-serif" }}
            >
              {BRAND_LETTERS.map((char, idx) => (
                <span
                  key={`e2-${idx}`}
                  className="inline-block login-bounce-letter"
                  style={{ animationDelay: `${idx * 90 + 60}ms` }}
                >
                  {char}
                </span>
              ))}
            </div>

            {/* Echo Layer 1 (Canva Echo offset: 20 primary echo in #c1ff72) */}
            <div
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center font-baloo font-extrabold tracking-[-0.025em] leading-none text-[3.15rem] sm:text-[3.5rem] text-[#c1ff72] login-echo-layer-1"
              style={{ fontFamily: "'Baloo 2', 'Baloo Bhai 2', 'Outfit', system-ui, sans-serif" }}
            >
              {BRAND_LETTERS.map((char, idx) => (
                <span
                  key={`e1-${idx}`}
                  className="inline-block login-bounce-letter"
                  style={{ animationDelay: `${idx * 90 + 30}ms` }}
                >
                  {char}
                </span>
              ))}
            </div>

            {/* Main Foreground Text: Pure Black (#000000) with looping character bounce animation */}
            <h1
              className="relative z-10 flex items-center justify-center font-baloo font-extrabold tracking-[-0.025em] leading-none text-[3.15rem] sm:text-[3.5rem] text-[#000000] m-0 p-0"
              style={{ fontFamily: "'Baloo 2', 'Baloo Bhai 2', 'Outfit', system-ui, sans-serif" }}
            >
              {BRAND_LETTERS.map((char, idx) => (
                <span
                  key={`main-${idx}`}
                  className="inline-block login-bounce-letter"
                  style={{ animationDelay: `${idx * 90}ms` }}
                >
                  {char}
                </span>
              ))}
            </h1>
          </div>
        </div>
      </div>
    </div>
  );
};
