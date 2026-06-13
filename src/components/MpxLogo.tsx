interface Props {
  className?: string;
}

/// The MusicPax mark (peace ring + blue up-arrow). Inline SVG so it scales
/// cleanly and inherits sizing from CSS. Source: Desktop/mpx.svg.
export default function MpxLogo({ className }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 214.7 214.69"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#fff"
        opacity="0.75"
        d="M107.35.05C19.09-2.81-33.21,109.3,23.82,175.14l12.05-12.15C-8.25,110.07,29.92,21.47,98.85,17.46v82l17-17.15V17.46c69.06,4.01,107.15,92.86,62.83,145.73l12.03,12.16C248,109.56,195.72-2.82,107.35.05Z"
      />
      <path
        fill="#fff"
        opacity="0.75"
        d="M167.19,175.39c-31.73,29.79-87.94,29.79-119.68,0h-23.49c39.22,52.12,127.44,52.12,166.66,0h-23.49Z"
      />
      <path
        fill="#3dace0"
        d="M178.69,163.19l-59.46-60.13-3.37-3.41v-17.34c-19.59,19.76-72.26,72.89-92.03,92.83.07.08.13.16.2.24h23.5l51.33-52.78v75.04h0l17,17.04v-91.87l51.34,52.56s23.49,0,23.49,0c.01-.01.02-.03.03-.04l-12.03-12.16Z"
      />
    </svg>
  );
}
