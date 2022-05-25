import initialize from '@heliosphere/opentelemetry-sdk';
initialize({ apiToken: process.env.HS_TOKEN, serviceName: 'users-service', enable: true });

import { UsersService } from './users';
import { Controller, Get, HttpStatus, Module, Post, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response } from 'express';

@Controller()
class ApplicationController {
    private readonly usersService: UsersService = new UsersService();

    @Get('health')
    health(@Req() _req: Request, @Res() res: Response): void {
        res.status(HttpStatus.OK).send('OK');
    }

    @Get('users')
    getUser(@Req() req: Request, @Res() res: Response): void {
        const id = req.query.id as string;
        this.usersService.findInPostgres({ id: parseInt(id) }, (rows) => res.status(HttpStatus.OK).send(rows));
    }

    @Post('users/by-email')
    getUserByEmail(@Req() req: Request, @Res() res: Response): void {
        const email = req.body.email as string;
        if (email) {
            this.usersService.findInPostgres({ email }, (rows) => res.status(HttpStatus.OK).send(rows));
            return;
        }
    }

    @Post('users')
    async createUser(@Req() req: Request, @Res() res: Response): Promise<void> {
        const result = await this.usersService.saveInPostgres(req.body);
        res.status(HttpStatus.OK).send(result);
    }
}

@Module({ controllers: [ApplicationController] })
class ApplicationModule { }

NestFactory.create(ApplicationModule).then((nestApplication) => {
    const port = 8081;
    nestApplication.listen(port);
    console.log(`Demo users service listening on port ${port}.`);
});
