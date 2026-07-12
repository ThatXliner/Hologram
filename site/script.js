const header = document.querySelector('[data-header]');
const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('#site-nav');
const stageImage = document.querySelector('#stage-image');
const stageButtons = document.querySelectorAll('.stage-button');

const updateHeader = () => header?.classList.toggle('scrolled', window.scrollY > 18);
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

menuButton?.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  nav?.classList.toggle('open', !isOpen);
});

nav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    menuButton?.setAttribute('aria-expanded', 'false');
    nav.classList.remove('open');
  });
});

stageButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!stageImage || button.classList.contains('active')) return;

    stageButtons.forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    stageImage.classList.add('swapping');

    const nextImage = new Image();
    nextImage.src = button.dataset.src;
    nextImage.onload = () => {
      stageImage.src = nextImage.src;
      stageImage.alt = button.dataset.alt ?? '';
      requestAnimationFrame(() => stageImage.classList.remove('swapping'));
    };
  });
});

document.querySelectorAll('[data-year]').forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reducedMotion || !('IntersectionObserver' in window)) {
  document.querySelectorAll('.reveal').forEach((node) => node.classList.add('visible'));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll('.reveal').forEach((node) => observer.observe(node));
}
