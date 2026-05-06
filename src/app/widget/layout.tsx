// Server component: injects a <style> tag into the initial HTML so html/body
// are transparent on first paint. Two things to defeat:
//   1) Global `bg-bg` / cream background from globals.css filling the 64x64
//      BrowserWindow for a frame.
//   2) `:root { color-scheme: light }` from globals.css telling Chromium the
//      page canvas is light-mode → Chromium paints a white default canvas
//      *behind* the body, which a transparent body lets through. That's the
//      white squircle you see around the bubble icon.
export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            :root { color-scheme: normal !important; }
            html, body {
              background: transparent !important;
              background-color: transparent !important;
              overflow: hidden !important;
              margin: 0;
            }

            /* ========= Widget animations ========= */

            @keyframes wgFadeInUp {
              from { opacity: 0; transform: translateY(8px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            @keyframes wgFadeIn {
              from { opacity: 0; }
              to   { opacity: 1; }
            }
            @keyframes wgSlideInRight {
              from { opacity: 0; transform: translateX(28px); }
              to   { opacity: 1; transform: translateX(0); }
            }
            @keyframes wgSlideInLeft {
              from { opacity: 0; transform: translateX(-28px); }
              to   { opacity: 1; transform: translateX(0); }
            }
            @keyframes wgScaleIn {
              from { opacity: 0; transform: scale(0.92); }
              to   { opacity: 1; transform: scale(1); }
            }
            @keyframes wgPopInBubble {
              0%   { opacity: 0; transform: scale(0.85) translateX(10px); }
              60%  { opacity: 1; transform: scale(1.03) translateX(-2px); }
              100% { opacity: 1; transform: scale(1) translateX(0); }
            }
            @keyframes wgPulseSoft {
              0%, 100% { transform: scale(1); }
              50%      { transform: scale(1.025); }
            }
            @keyframes wgShimmer {
              0%   { background-position: -200% 0; }
              100% { background-position: 200% 0; }
            }
            @keyframes wgAckBurst {
              0%   { transform: scale(1); }
              40%  { transform: scale(1.15); }
              100% { transform: scale(1); }
            }

            /* easing: gentle deceleration */
            .ease-snap { animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1); }

            .anim-fade-in        { animation: wgFadeIn 220ms cubic-bezier(0.2,0.8,0.2,1) both; }
            .anim-fade-in-up     { animation: wgFadeInUp 280ms cubic-bezier(0.2,0.8,0.2,1) both; }
            .anim-slide-in-right { animation: wgSlideInRight 280ms cubic-bezier(0.2,0.8,0.2,1) both; }
            .anim-slide-in-left  { animation: wgSlideInLeft 280ms cubic-bezier(0.2,0.8,0.2,1) both; }
            .anim-scale-in       { animation: wgScaleIn 220ms cubic-bezier(0.2,0.8,0.2,1) both; }
            .anim-pop-bubble {
              animation:
                wgPopInBubble 360ms cubic-bezier(0.2,0.8,0.2,1) both,
                wgPulseSoft 1.4s ease-in-out 360ms infinite;
            }
            .anim-ack-burst { animation: wgAckBurst 320ms cubic-bezier(0.2,0.8,0.2,1) both; }

            /* All transitions snappy by default. */
            .wg-card {
              transition: transform 160ms cubic-bezier(0.2,0.8,0.2,1),
                          box-shadow 200ms ease,
                          border-color 160ms ease,
                          background-color 160ms ease;
            }
            .wg-card:hover { transform: translateY(-1px); }
            .wg-card:active { transform: translateY(0) scale(0.99); }

            .wg-bubble-btn {
              transition: transform 140ms cubic-bezier(0.2,0.8,0.2,1),
                          filter 220ms ease;
            }
            .wg-bubble-btn:hover { transform: scale(1.06); filter: drop-shadow(0 6px 14px rgba(0,0,0,0.4)); }
            .wg-bubble-btn:active { transform: scale(0.94); }
          `
        }}
      />
      {children}
    </>
  );
}
