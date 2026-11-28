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
      className={`w-full max-w-none sm:max-w-md xl:max-w-[480px] 2xl:max-w-[500px] relative z-0 pointer-events-none select-none overflow-hidden bg-[#ffcc00] sm:rounded-b-3xl transition-[min-height,height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] flex items-center justify-center ${
        isKeyboardOpen
          ? 'flex-1 min-h-[112px] sm:flex-none sm:min-h-0 sm:h-[120px] opacity-85'
          : 'flex-1 min-h-[190px] sm:flex-none sm:min-h-0 sm:h-[clamp(215px,calc(100dvh-330px),440px)] xl:h-[clamp(260px,calc(100dvh-360px),515px)] 2xl:h-[clamp(320px,calc(100dvh-390px),640px)] opacity-100'
      }`}
    >
      <div
        className={`w-full flex items-center justify-center px-4 transition-all duration-300 ${
          isKeyboardOpen ? 'pt-10 pb-6 sm:pt-3 sm:pb-4' : 'pt-24 pb-4 sm:pt-20 sm:pb-4 xl:pt-28 xl:pb-6 2xl:pt-36 2xl:pb-6'
        }`}
      >
        <div className="relative inline-flex items-center justify-center">
          {/* Echo Layer 2 (Canva Echo offset: 20 secondary trail in #c1ff72) */}
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center font-baloo font-extrabold tracking-[-0.025em] leading-none text-[3.15rem] sm:text-[3.35rem] lg:text-[3.6rem] xl:text-[4rem] text-[#c1ff72] login-echo-layer-2"
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
            className="absolute inset-0 flex items-center justify-center font-baloo font-extrabold tracking-[-0.025em] leading-none text-[3.15rem] sm:text-[3.35rem] lg:text-[3.6rem] xl:text-[4rem] text-[#c1ff72] login-echo-layer-1"
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
            className="relative z-10 flex items-center justify-center font-baloo font-extrabold tracking-[-0.025em] leading-none text-[3.15rem] sm:text-[3.35rem] lg:text-[3.6rem] xl:text-[4rem] text-[#000000] m-0 p-0"
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
  );
};
