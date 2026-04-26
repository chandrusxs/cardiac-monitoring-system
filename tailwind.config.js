/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  safelist: [
    "min-h-[300px]",
    "p-8",
    "gap-10",
    "w-16",
    "h-64",
    "rounded-[2rem]",
    "col-span-full",
    "shadow-xl",
    "border-slate-200",
    "text-slate-900",
    "text-slate-600",
  ],
  theme: {
    extend: {
      keyframes: {
        "slow-pulse": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.9" },
          "50%": { transform: "scale(1.08)", opacity: "1" },
        },
      },
      animation: {
        "slow-pulse": "slow-pulse 2.8s ease-in-out infinite",
      },
      transitionTimingFunction: {
        premium: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
