import { Suspense } from 'react' ;
import { Tr } from '@/components/Translate' ; import SupportClient from './SupportClient' ; export async function generateMetadata() {
  const { t } = await getServerI18n() ;
  return { title: t('meta.supportTitle'), description: t('meta.supportDescription') } ;
}
import { getServerI18n } from '@/lib/i18n/server'; function SupportFallback() { return <main className='card' style={{ maxWidth: 800, margin: '40px auto', textAlign: 'center' }}><p><Tr k="common.loading" /></p></main> } export default function SupportPage() { return ( <Suspense fallback={<SupportFallback />}><SupportClient /></Suspense> ) }