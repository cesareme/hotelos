# Cocoa Edition · Guia de Integracion

## 1. Montaje en App.tsx
```tsx
import { CocoaGlobalProvider } from './providers/CocoaGlobalProvider';

function App() {
  return (
    <CocoaGlobalProvider>
      <BackOfficeLayout />
    </CocoaGlobalProvider>
  );
}
```

## 2. Estilos globales (main.tsx o equivalent)
```ts
import './styles/cocoa-tokens.css';
import './styles/cocoa-base.css';
import './styles/cocoa-motion.css';
```

## 3. Uso en pantallas
```tsx
import { CocoaPageHeader, CocoaCard, CocoaButton } from '../components/cocoa';
import { useCocoaNotifications } from '../providers/CocoaGlobalProvider';

function MyScreen() {
  const { push } = useCocoaNotifications();
  return (
    <>
      <CocoaPageHeader title='...' />
      <CocoaCard variant='elevated' padding='lg'>...</CocoaCard>
      <CocoaButton onClick={() => push({ title: 'Hecho' })}>Guardar</CocoaButton>
    </>
  );
}
```

## 4. Tema dinamico
El tema se aplica via data-theme en document.documentElement (light/dark). Auto leeprefers-color-scheme.

For accent color: setProperty --cocoa-accent en root.

## 5. Showcase
Navega a /developer/cocoa-showcase para ver TODOS los componentes en vivo.

## 6. Verificacion
- typecheck: npm --workspace @hotelos/admin-web run typecheck
- lint: npm --workspace @hotelos/admin-web run lint
- build: npm --workspace @hotelos/admin-web run build
