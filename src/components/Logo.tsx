/// STACK wordmark: white lettering with the blue up-arrow mark.
export default function Logo() {
  return (
    <div className="brand" title="STACK">
      <span className="brand-word">STACK</span>
      <svg
        className="brand-arrow"
        viewBox="0 0 120 120"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* arrowhead + shaft */}
        <polygon points="60,2 86,36 68,36 68,112 52,98 52,36 34,36" />
        {/* left wing */}
        <polygon points="12,94 42,58 51,69 22,104" />
        {/* right wing */}
        <polygon points="108,94 78,58 69,69 90,94 90,118 98,106" />
      </svg>
    </div>
  );
}
