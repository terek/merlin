import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { EventsProvider } from './api/events'
import { createQueryClient } from './api/queries'
import './styles.css'

const queryClient = createQueryClient()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <EventsProvider>
          <App />
        </EventsProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
