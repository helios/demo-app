import { createConnection, Column, Entity, PrimaryColumn, Repository, PrimaryGeneratedColumn } from 'typeorm';

export interface User {
    id?: number,
    name?: string,
    email?: string,
}

@Entity('users')
export class TypeormUser {
    @PrimaryGeneratedColumn('increment')
    id: number;
    @Column('varchar')
    name: string;
    @Column('varchar', { unique: true })
    email: string;

    static toTypeormUser(user: User): TypeormUser {
        const typeormUser = new TypeormUser();
        typeormUser.id = user.id;
        typeormUser.name = user.name;
        typeormUser.email = user.email;
        return typeormUser;
    }
}

export class UsersService {
    private postgres: Repository<TypeormUser>;

    constructor() {
        this.initializeTypeorm();
    }

    private async initializeTypeorm() {
        const connection = await createConnection({
            database: process.env.PG_DB || 'users',
            entities: [TypeormUser],
            host: process.env.PG_HOST || 'localhost',
            password: process.env.PG_PASSWORD || 'password',
            synchronize: true,
            type: 'postgres',
            username: process.env.PG_USER || 'users',
        });
        this.postgres = connection.getRepository(TypeormUser);
    }

    findInPostgres(user: User, callback: (rows: TypeormUser[]) => void) {
        this.postgres.find({ where: user }).then(callback);
    }

    saveInPostgres(user: User) {
        return this.postgres.save(TypeormUser.toTypeormUser(user));
    }
}
