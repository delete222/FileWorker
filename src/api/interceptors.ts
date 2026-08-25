import axios, { AxiosError } from 'axios';
import router from '@/router';
import { toast } from '@/utils/toast';

const initInterceptors = () => {
    axios.interceptors.response.use(
        async (response) => response,
        async (error: AxiosError) => {
            toast("Error", "error");
            if (error.response?.status === 401 && router.currentRoute.value.path !== '/guding') {
                await router.push('/login');
            }
            return Promise.reject(error);
        });
}

export { initInterceptors };
